import { test } from 'node:test'
import assert from 'node:assert/strict'
import { relativeCoursePath, parentCoursePath, coursePickerPath } from '../src/filePaths.ts'

test('POSIX courses keep separators, case and literal backslashes', () => {
  assert.equal(relativeCoursePath('/home/student/课程/', '/home/student/课程/第一章/题目.pdf'), '第一章/题目.pdf')
  assert.equal(relativeCoursePath('/home/student/Course', '/home/student/course/a.pdf'), null)
  assert.equal(relativeCoursePath('/home/course', '/home/course-other/a.pdf'), null)
  assert.equal(parentCoursePath('/home', 'chapter\\name/a.pdf'), 'chapter\\name')
  assert.equal(coursePickerPath('/home/student/', '第一章'), '/home/student/第一章')
  assert.equal(relativeCoursePath('/', '/course/a.pdf'), 'course/a.pdf')
  assert.equal(coursePickerPath('/', 'course'), '/course')
})

test('Windows drive and UNC paths keep native separators and ignore case', () => {
  assert.equal(relativeCoursePath('D:\\Course\\', 'd:\\course\\chapter\\a.pdf'), 'chapter\\a.pdf')
  assert.equal(relativeCoursePath('D:/Course', 'd:\\course\\chapter\\a.pdf'), 'chapter\\a.pdf')
  assert.equal(relativeCoursePath('\\\\server\\share', '\\\\server\\share\\chapter\\a.pdf'), 'chapter\\a.pdf')
  assert.equal(parentCoursePath('D:\\Course', 'chapter\\a.pdf'), 'chapter')
  assert.equal(coursePickerPath('D:\\Course\\', 'chapter'), 'D:\\Course\\chapter')
  assert.equal(relativeCoursePath('C:\\', 'C:\\a.pdf'), 'a.pdf')
  assert.equal(coursePickerPath('', ''), undefined)
})
